/** Bounded single Unicode emoji sequence; no second emoji dataset or text payloads. */
type Segments = { segment(value: string): Iterable<{ segment: string }> };
const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locale: string, options: { granularity: 'grapheme' }) => Segments }).Segmenter;
const segmenter = Segmenter ? new Segmenter('en', { granularity: 'grapheme' }) : null;
const pictograph = String.raw`\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?`;
const emoji = new RegExp(String.raw`^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|${pictograph}(?:[\u{e0061}-\u{e007a}]{2,7}\u{e007f}|(?:\u200D${pictograph})*))$`, 'u');
export function isReactionEmoji(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && Boolean(segmenter) &&
    [...segmenter!.segment(value)].length === 1 && emoji.test(value);
}
