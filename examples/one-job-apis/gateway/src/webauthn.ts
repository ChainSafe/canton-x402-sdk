// Passkey registration and payment approval (platform biometrics when available).
//
// SPDX-License-Identifier: Apache-2.0

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { RP_ID, RP_NAME, RP_ORIGIN } from "./config.ts";
import { findPasskey, passkeysForUser, savePasskey } from "./store.ts";

export async function registrationOptions(userId: string, userName: string) {
  const existing = passkeysForUser(userId);
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
      authenticatorAttachment: "platform",
    },
    excludeCredentials: existing.map((cred) => ({
      id: cred.credentialId,
      transports: cred.transports,
    })),
  });
}

export async function verifyRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<void> {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: RP_ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Could not verify passkey registration.");
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  void credentialDeviceType;
  void credentialBackedUp;
  savePasskey({
    userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports as AuthenticatorTransportFuture[] | undefined,
  });
}

export async function authenticationOptions(userId: string) {
  const passkeys = passkeysForUser(userId);
  if (passkeys.length === 0) throw new Error("Register your fingerprint first.");
  return generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "required",
    allowCredentials: passkeys.map((cred) => ({
      id: cred.credentialId,
      transports: cred.transports,
    })),
  });
}

export async function verifyAuthentication(
  userId: string,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<void> {
  const passkey = findPasskey(response.id);
  if (!passkey || passkey.userId !== userId) throw new Error("Unknown passkey.");
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: RP_ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
    credential: {
      id: passkey.credentialId,
      publicKey: Buffer.from(passkey.publicKey, "base64url"),
      counter: passkey.counter,
      transports: passkey.transports,
    },
  });
  if (!verification.verified) throw new Error("Fingerprint check failed.");
  savePasskey({ ...passkey, counter: verification.authenticationInfo.newCounter });
}