import {
  RegExpMatcher,
  TextCensor,
  asteriskCensorStrategy,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});
const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

/** Masks profanity with asterisks; everything else, whitespace included, is untouched. */
export function cleanText(s: string): string {
  const matches = matcher.getAllMatches(s);
  return matches.length ? censor.applyTo(s, matches) : s;
}
