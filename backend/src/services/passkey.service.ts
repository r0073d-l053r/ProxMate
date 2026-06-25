import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { prisma } from '../lib/prisma.js';

const RP_NAME = 'ProxMate';

/**
 * The Relying Party identity. `rpID` must equal the site's registrable domain
 * and `origin` the exact page origin — both derived from FRONTEND_URL, with
 * explicit overrides for deployments behind a different public hostname.
 */
function rp(): { origin: string; rpID: string } {
  const origin = process.env.WEBAUTHN_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';
  const rpID = process.env.WEBAUTHN_RP_ID || new URL(origin).hostname;
  return { origin, rpID };
}

const csvToTransports = (csv: string | null): AuthenticatorTransportFuture[] | undefined =>
  csv ? (csv.split(',') as AuthenticatorTransportFuture[]) : undefined;

// ─── Registration (enroll a new passkey; authenticated) ───────

export async function registrationOptions(
  userId: string,
  userName: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID } = rp();
  const existing = await prisma.passkey.findMany({ where: { userId } });
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    // Don't let the same authenticator enroll twice.
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: csvToTransports(c.transports) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
}

export async function verifyRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  name: string,
): Promise<void> {
  const { origin, rpID } = rp();
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Passkey registration could not be verified.');
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await prisma.passkey.create({
    data: {
      id: credential.id,
      userId,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports?.join(','),
      name: name.trim() || 'Passkey',
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    },
  });
}

// ─── Authentication (passwordless login; usernameless/discoverable) ───

export async function authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = rp();
  // No allowCredentials → the authenticator offers its discoverable passkeys.
  return generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
}

/** Verify an assertion → returns the owning userId (or throws). */
export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<string> {
  const { origin, rpID } = rp();
  const passkey = await prisma.passkey.findUnique({ where: { id: response.id } });
  if (!passkey) throw new Error('Unrecognized passkey.');

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: passkey.id,
      publicKey: new Uint8Array(passkey.publicKey),
      counter: passkey.counter,
      transports: csvToTransports(passkey.transports),
    },
  });
  if (!verification.verified) throw new Error('Passkey authentication failed.');

  await prisma.passkey.update({
    where: { id: passkey.id },
    data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() },
  });
  return passkey.userId;
}

// ─── Management ───────────────────────────────────────────────

export function listPasskeys(userId: string) {
  return prisma.passkey.findMany({
    where: { userId },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function deletePasskey(userId: string, id: string): Promise<void> {
  await prisma.passkey.deleteMany({ where: { id, userId } });
}
