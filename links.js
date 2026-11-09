/** Exact FOMO URL builders — mirror of desk/links.py. Never shorten. */
export const CHAIN_ID = { solana: 1399811149, robinhood: 4663, base: 8453, bnb: 56 };
export const SIGNUP_URL = "https://fomo.family/r/savipww";

export function coinUrl(address, chain = "solana") {
  if (!(chain in CHAIN_ID)) return SIGNUP_URL;
  return (
    "https://fomo.family/coin?address=" +
    address +
    "&chainId=" +
    CHAIN_ID[chain] +
    "&r=savipww&source=share_link"
  );
}

export function profileUrl(handle) {
  const h = String(handle || "").replace(/^@/, "");
  return "https://fomo.family/profile/" + h + "?source=share_link&r=savipww";
}
