/**
 * The arithmetic of Banco Horizonte's fictitious loan.
 *
 * Both functions are self-contained on purpose: the page's script carries their source
 * (`client.ts` embeds `toString()` of each), so the figures the browser shows are the ones tested
 * here. Neither may reference anything outside its own body.
 *
 * **The terms are fictitious and the decision is simulated.** A PID says who a person is; it says
 * nothing about what they can repay. The income the "decision" uses is typed by the person.
 */

/** The fictitious product: nominal annual rate in percent, and the share of income a payment may take. */
export const LOAN_TERMS = {
  annualRatePercent: 6.95,
  maxPaymentShare: 0.35,
  minAmount: 3_000,
  maxAmount: 30_000,
  stepAmount: 500,
  defaultAmount: 10_000,
  months: [12, 24, 36, 48, 60, 72, 84],
  defaultMonths: 48,
} as const;

/** The constant monthly payment of an amortising loan, to the cent. */
export const monthlyPayment = (amount: number, months: number, annualRatePercent: number) => {
  const r = annualRatePercent / 100 / 12;
  const payment = r === 0 ? amount / months : (amount * r) / (1 - (1 + r) ** -months);
  return Math.round(payment * 100) / 100;
};

/**
 * The largest amount, in whole steps, whose payment stays within `share` of the monthly income —
 * never more than what was asked for, and `0` when not even the smallest step fits.
 */
export const affordableAmount = (
  asked: number,
  monthlyIncome: number,
  months: number,
  annualRatePercent: number,
  share: number,
  step: number,
) => {
  const r = annualRatePercent / 100 / 12;
  const perUnit = r === 0 ? 1 / months : r / (1 - (1 + r) ** -months);
  const ceiling = Math.floor((monthlyIncome * share) / perUnit / step) * step;
  return Math.max(0, Math.min(asked, ceiling));
};
