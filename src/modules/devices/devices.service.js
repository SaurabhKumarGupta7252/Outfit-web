import { hashIp, safeEqualHex, sha256 } from '../../utils/crypto.js';
import { forbidden, unauthorized } from '../../utils/errors.js';

// Creates or loads the installation row and locks it for the rest of the transaction.
// The app generates installationUuid and guestSecret once and stores them securely; the
// secret proves that a later request comes from the same installation.
//
// ssaid is Android's Settings.Secure.ANDROID_ID: a device-scoped identifier that survives
// app reinstalls (same signing key, same user profile), so we use its hash as an extra
// signal in the free-credit check. It is stored only as a hash.
export async function lockInstallation(client, { installationUuid, guestSecret, platform, appVersion, deviceModel, ssaid, deviceFingerprint, ip }) {
  const secretHash = sha256(guestSecret);
  const ipHash = hashIp(ip);
  const ssaidHash = ssaid ? sha256(ssaid) : null;

  await client.query(
    `INSERT INTO device_installations
       (installation_uuid, secret_hash, platform, app_version, device_model, first_ip_hash, last_ip_hash, ssaid_hash, device_fingerprint)
     VALUES ($1, $2, COALESCE($3, 'android'), $4, $5, $6, $6, $7, $8)
     ON CONFLICT (installation_uuid) DO NOTHING`,
    [installationUuid, secretHash, platform ?? null, appVersion ?? null, deviceModel ?? null, ipHash, ssaidHash, deviceFingerprint ?? null],
  );
  const { rows } = await client.query(
    'SELECT * FROM device_installations WHERE installation_uuid = $1 FOR UPDATE',
    [installationUuid],
  );
  const installation = rows[0];

  if (!safeEqualHex(installation.secret_hash, secretHash)) {
    throw unauthorized('This installation could not be verified.', 'INSTALLATION_MISMATCH');
  }
  if (installation.risk_status === 'blocked') {
    throw forbidden('This device is not allowed to use the service.', 'DEVICE_BLOCKED');
  }

  // Fill in ssaid_hash on an older installation that was created before this column existed,
  // and keep the latest values on every call.
  await client.query(
    `UPDATE device_installations
        SET last_seen_at = now(),
            last_ip_hash = COALESCE($2, last_ip_hash),
            app_version = COALESCE($3, app_version),
            device_model = COALESCE($4, device_model),
            ssaid_hash = COALESCE(ssaid_hash, $5),
            device_fingerprint = COALESCE(device_fingerprint, $6)
      WHERE id = $1`,
    [installation.id, ipHash, appVersion ?? null, deviceModel ?? null, ssaidHash, deviceFingerprint ?? null],
  );
  // Return the up-to-date row so the eligibility check sees the ssaid_hash.
  installation.ssaid_hash ??= ssaidHash;
  installation.device_fingerprint ??= deviceFingerprint ?? null;
  return installation;
}

export function presentInstallation(installation) {
  return {
    id: installation.id,
    installationUuid: installation.installation_uuid,
    platform: installation.platform,
    appVersion: installation.app_version,
    firstSeenAt: installation.first_seen_at,
    lastSeenAt: installation.last_seen_at,
    freeCreditClaimed: installation.free_credit_claimed,
    freeCreditClaimedAt: installation.free_credit_claimed_at,
    riskStatus: installation.risk_status,
  };
}
