/**
 * Deploy-service payments: Lightning (Nostr zap receipts) and PRE
 * (Presearch ERC-20 on Base). Verified payments become a one-time deploy
 * credit for the paying Nostr pubkey.
 *
 * Lightning: a valid kind 9735 zap receipt to the service's zap npub for at
 * least the current price. The receipt is issued and signed by the
 * recipient's LNURL server after settlement — see docs/SECURITY.md.
 *
 * PRE: the customer sends PRE on Base (chain 8453) to the service wallet and
 * submits the tx hash; the worker verifies on-chain via the public Base RPC:
 * confirmed receipt, a Transfer log on the PRE contract to the service
 * wallet, value ≥ current price. Tx hashes are single-use (replay-proof).
 *
 * @module src/service/pay
 */

import * as config from '../config';
import { verifyZapReceipt } from '../pay';
import { getServiceSettings } from './settings';
import type { NostrEvent } from '../types';

type Session = D1DatabaseSession;

/* ------------------------------------------------------------------ */
/* Credit ledger                                                       */
/* ------------------------------------------------------------------ */

async function recordPayment(
  session: Session,
  pubkey: string,
  method: 'lightning' | 'pre',
  amount: string,
  proof: string,
  payerDetail?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await session
      .prepare(
        `INSERT INTO deploy_payments (pubkey, method, amount, proof, payer_detail)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(pubkey, method, amount, proof, payerDetail ?? null)
      .run();
    return { ok: true };
  } catch (error: any) {
    if (String(error?.message ?? '').includes('UNIQUE')) {
      return { ok: false, error: 'this payment proof was already used' };
    }
    console.error('recordPayment failed:', error);
    return { ok: false, error: 'could not record payment' };
  }
}

/** Does this pubkey have an unused deploy credit? */
export async function hasDeployCredit(session: Session, pubkey: string): Promise<boolean> {
  const row = await session
    .prepare('SELECT id FROM deploy_payments WHERE pubkey = ? AND used_at IS NULL LIMIT 1')
    .bind(pubkey)
    .first();
  return row !== null;
}

/** Consume the oldest unused credit for a pubkey. Returns its payment id. */
export async function consumeDeployCredit(session: Session, pubkey: string): Promise<number | null> {
  const row = await session
    .prepare('SELECT id FROM deploy_payments WHERE pubkey = ? AND used_at IS NULL ORDER BY id ASC LIMIT 1')
    .bind(pubkey)
    .first();
  if (!row) return null;
  await session
    .prepare("UPDATE deploy_payments SET used_at = strftime('%s', 'now') WHERE id = ?")
    .bind(row.id)
    .run();
  return row.id as number;
}

/* ------------------------------------------------------------------ */
/* Lightning (zap receipt)                                             */
/* ------------------------------------------------------------------ */

export async function payWithLightning(
  session: Session,
  event: NostrEvent,
  claimedPubkey: string,
  verifySig: (event: NostrEvent) => Promise<boolean>,
): Promise<{ ok: boolean; error?: string }> {
  const settings = await getServiceSettings(session);
  const priceSats = parseInt(settings.deploy_price_sats, 10);

  const verified = await verifyZapReceipt(event, settings.zap_npub, priceSats, verifySig);
  if (!verified) {
    return { ok: false, error: 'invalid zap receipt (recipient, amount, or signature)' };
  }
  if (verified.payer !== claimedPubkey) {
    return { ok: false, error: 'zap sender (P tag) does not match the logged-in pubkey' };
  }

  return recordPayment(
    session,
    claimedPubkey,
    'lightning',
    String(verified.amountSats),
    verified.receiptId,
    verified.bolt11?.slice(0, 64),
  );
}

/* ------------------------------------------------------------------ */
/* PRE on Base (EVM)                                                   */
/* ------------------------------------------------------------------ */

/** ERC-20 Transfer event topic. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface RpcReceipt {
  status?: string;
  from?: string;
  logs?: Array<{ address: string; topics: string[]; data: string }>;
  blockNumber?: string;
}

async function baseRpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(config.BASE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`);
  const data = (await res.json()) as { result?: any; error?: { message?: string } };
  if (data.error) throw new Error(`Base RPC ${data.error.message || 'error'}`);
  return data.result;
}

/** Normalize a 32-byte topic or address to a lowercase 0x address. */
function toAddress(topicOrAddress: string): string {
  return '0x' + topicOrAddress.slice(-40).toLowerCase();
}

export async function payWithPre(
  session: Session,
  txHash: string,
  claimedPubkey: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, error: 'not a valid transaction hash' };
  }
  const settings = await getServiceSettings(session);
  const serviceAddress = settings.pre_address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(serviceAddress)) {
    return { ok: false, error: 'service PRE wallet is not configured' };
  }

  let receipt: RpcReceipt | null;
  try {
    receipt = await baseRpc('eth_getTransactionReceipt', [txHash]);
  } catch (error: any) {
    return { ok: false, error: `could not reach Base RPC: ${error.message}` };
  }
  if (!receipt || !receipt.status) {
    return { ok: false, error: 'transaction not found on Base yet — try again in a few seconds' };
  }
  if (receipt.status !== '0x1') {
    return { ok: false, error: 'transaction failed on-chain' };
  }

  const pricePre = BigInt(settings.deploy_price_pre || '0');
  const minValue = pricePre * 10n ** BigInt(config.PRE_TOKEN_DECIMALS);
  const contract = config.PRE_TOKEN_CONTRACT.toLowerCase();

  const matching = (receipt.logs ?? []).filter((log) => {
    if (log.address.toLowerCase() !== contract) return false;
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
    if (toAddress(log.topics[2] || '') !== serviceAddress) return false;
    let value = 0n;
    try {
      value = BigInt(log.data);
    } catch {
      return false;
    }
    return value >= minValue;
  });

  if (matching.length === 0) {
    return { ok: false, error: 'no qualifying PRE transfer to the service wallet in this transaction' };
  }

  return recordPayment(
    session,
    claimedPubkey,
    'pre',
    settings.deploy_price_pre,
    txHash.toLowerCase(),
    receipt.from?.toLowerCase(),
  );
}
