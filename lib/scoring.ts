/**
 * Where the score turns into a verdict.
 *
 * The four 0-25 dimensions are judgement calls the model makes from evidence;
 * the Pursue/Nurture/Reject label is not. Letting the model pick it too produced
 * rows with identical sub-scores and opposite verdicts — three leads at 70/100
 * with 25/25 legitimacy and 25/25 AI relevance came back as both Pursue and
 * Reject. Deriving it here makes the boundary explicit, reviewable, and yours
 * to move.
 */

export type Recommendation = "Pursue" | "Nurture" | "Reject";

/** Lower bound of each band, in composite score out of 100. */
export const PURSUE_AT = 70;
export const NURTURE_AT = 40;

export function recommendationFor(total: number): Recommendation {
  if (total >= PURSUE_AT) return "Pursue";
  if (total >= NURTURE_AT) return "Nurture";
  return "Reject";
}

/** Stated in the scoring prompt so the model's rationale matches the verdict. */
export const THRESHOLD_NOTE =
  `The Pursue/Nurture/Reject verdict is not yours to choose — it is derived from the total: ` +
  `${PURSUE_AT}+ is Pursue, ${NURTURE_AT}-${PURSUE_AT - 1} is Nurture, below ${NURTURE_AT} is Reject.`;
