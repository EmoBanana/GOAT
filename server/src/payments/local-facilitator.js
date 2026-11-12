import crypto from 'node:crypto';
import { authorizationTypes } from '@x402/evm';
import { getAddress, verifyTypedData } from 'viem';

// A facilitator for x402-local: the real x402 v2 handshake and real EIP-3009 signatures,
// settled against data/ledger.json instead of Base Sepolia (works offline on stage).
export function createLocalFacilitator({ network, chainId = 84532, ledger, now = () => Date.now() }) {
  async function verify(payload, requirements) {
    const auth = payload?.payload?.authorization;
    const signature = payload?.payload?.signature;
    const invalid = (invalidReason, invalidMessage) => ({ isValid: false, invalidReason, invalidMessage, payer: auth?.from });
    if (!auth || !signature) return invalid('invalid_payload', 'The payment has no authorization or signature.');
    if (requirements.scheme !== 'exact' || requirements.network !== network) return invalid('unsupported_scheme', 'Only exact payments on this network.');
    let signed = false;
    try {
      signed = await verifyTypedData({
        address: auth.from,
        domain: { name: requirements.extra?.name, version: requirements.extra?.version, chainId, verifyingContract: requirements.asset },
        types: authorizationTypes,
        primaryType: 'TransferWithAuthorization',
        message: auth,
        signature,
      });
    } catch {
      signed = false;
    }
    if (!signed) return invalid('invalid_exact_evm_payload_signature', "The signature doesn't match.");
    if (getAddress(auth.to) !== getAddress(requirements.payTo)) return invalid('invalid_exact_evm_payload_recipient_mismatch', 'The payment goes to someone else.');
    if (BigInt(auth.value) < BigInt(requirements.amount)) return invalid('invalid_exact_evm_payload_authorization_value', 'The payment is too small.');
    const t = BigInt(Math.floor(now() / 1000));
    if (BigInt(auth.validBefore) <= t || BigInt(auth.validAfter) > t) return invalid('invalid_exact_evm_payload_authorization_valid_before', 'The payment authorization has expired.');
    if (ledger.nonceUsed(auth.nonce)) return invalid('invalid_exact_evm_payload_authorization_nonce', 'This payment was already used.');
    if (ledger.balance(auth.from) < BigInt(auth.value)) return invalid('insufficient_funds', 'Not enough balance. Top up to keep asking.');
    return { isValid: true, payer: auth.from };
  }

  async function settle(payload, requirements) {
    const check = await verify(payload, requirements); // the balance may have changed since verify
    if (!check.isValid) return { success: false, errorReason: check.invalidReason, errorMessage: check.invalidMessage, transaction: '', network, payer: check.payer };
    const auth = payload.payload.authorization;
    ledger.useNonce(auth.nonce);
    const transaction = `0x${crypto.createHash('sha256').update(payload.payload.signature).digest('hex')}`;
    ledger.debit(auth.from, BigInt(auth.value), { to: getAddress(auth.to), nonce: auth.nonce, transaction });
    return { success: true, transaction, network, payer: auth.from };
  }

  return {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network }], extensions: [], signers: {} }),
    verify,
    settle,
  };
}
