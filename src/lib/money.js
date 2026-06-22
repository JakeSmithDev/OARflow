// Money is always stored as integer cents. These helpers format for display.

export function formatCents(cents, currency = 'USD') {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

export function centsToDollarsString(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

export default { formatCents, centsToDollarsString };
