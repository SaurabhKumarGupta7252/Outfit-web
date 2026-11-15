import { getSetting } from './settings.js';

// Decides whether an installation may receive the one-time free credits.
// This is deliberately a separate service: Play Integrity verdicts and Device Recall can be
// added here later without touching the wallet or auth code.
//
// Signals used today:
//   1. the installation has not claimed before (enforced again inside fn_grant_free_credits);
//   2. risk_status set by an admin or by a future integrity check;
//   3. the SSAID (Android device identifier, scoped to the app signing key and the user
//      profile): if any OTHER installation with the same SSAID already claimed, this one is
//      denied, so reinstalling the app and claiming again does not work;
//   4. how many installations first seen from the same network claimed in the last 24 hours.
// A new installation UUID alone is therefore not treated as proof of a new user.
export async function evaluateFreeCreditEligibility(client, installation) {
  if (installation.free_credit_claimed) return { eligible: false, reason: 'ALREADY_CLAIMED' };
  if (installation.risk_status === 'blocked' || installation.risk_status === 'suspicious') {
    return { eligible: false, reason: 'DEVICE_RISK' };
  }

  // SSAID-based reinstall protection. Only trip when another installation has already claimed.
  if (installation.ssaid_hash) {
    const { rows } = await client.query(
      `SELECT 1 FROM device_installations
        WHERE ssaid_hash = $1 AND id <> $2 AND free_credit_claimed = true LIMIT 1`,
      [installation.ssaid_hash, installation.id],
    );
    if (rows[0]) return { eligible: false, reason: 'DEVICE_ALREADY_CLAIMED' };
  }

  if (installation.first_ip_hash) {
    const { maxGrantsPerIpPerDay } = await getSetting('free_grant_limits');
    const { rows } = await client.query(
      `SELECT count(*)::int AS grants FROM device_installations
        WHERE first_ip_hash = $1 AND free_credit_claimed_at > now() - interval '24 hours'`,
      [installation.first_ip_hash],
    );
    if (rows[0].grants >= maxGrantsPerIpPerDay) return { eligible: false, reason: 'NETWORK_LIMIT' };
  }

  return { eligible: true, reason: null };
}
