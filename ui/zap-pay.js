/**
 * Zap receipt discovery — after a Lightning zap, the recipient's LNURL
 * server publishes a kind 9735 receipt to public relays. We fetch it
 * (`#P` = sender filter, with a `#p` recipient fallback) so it can be
 * submitted to a relay/service for cryptographic verification.
 *
 * @module ui/zap-pay
 */

import { reqEvents } from './ws.js';

const RECEIPT_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://sendit.nosflare.com'];

/**
 * Find the newest plausible zap receipt from `payerHex` to `recipientHex`.
 * @param {string} payerHex      zapper pubkey (P tag)
 * @param {string} recipientHex  recipient pubkey (p tag)
 * @param {number} sinceSec      unix seconds lower bound
 * @param {(msg: string) => void} [onStatus]
 */
export async function findZapReceipt(payerHex, recipientHex, sinceSec, onStatus = () => {}) {
  for (const relay of RECEIPT_RELAYS) {
    onStatus(`checking ${relay.replace('wss://', '')}…`);
    try {
      let { events } = await reqEvents(relay, [
        { kinds: [9735], '#P': [payerHex], since: sinceSec, limit: 10 },
      ], { timeoutMs: 6000 });

      if (events.length === 0 && recipientHex) {
        const fallback = await reqEvents(relay, [
          { kinds: [9735], '#p': [recipientHex], since: sinceSec, limit: 25 },
        ], { timeoutMs: 6000 });
        events = fallback.events.filter((ev) => ev.tags.some((t) => t[0] === 'P' && t[1] === payerHex));
      }

      const receipt = events
        .filter((ev) =>
          ev.kind === 9735 &&
          (!recipientHex || ev.tags.some((t) => t[0] === 'p' && t[1] === recipientHex)) &&
          ev.tags.some((t) => t[0] === 'P' && t[1] === payerHex) &&
          ev.tags.some((t) => t[0] === 'bolt11'))
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (receipt) return receipt;
    } catch (error) {
      console.warn(`[zap] receipt fetch from ${relay} failed:`, error);
    }
  }
  return null;
}
