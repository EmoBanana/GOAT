// USDC has 6 decimals. Amounts move around as BigInt atomic units, and as strings in JSON.
export const USDC_DECIMALS = 6;
export const usdToAtomic = (usd) => BigInt(Math.round(Number(usd) * 10 ** USDC_DECIMALS));
export const atomicToUsd = (atomic) => Number(BigInt(atomic)) / 10 ** USDC_DECIMALS;
export const roundMoney = (n) => Math.round(n * 100) / 100;
export const isAddress = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
