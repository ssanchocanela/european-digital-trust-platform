/**
 * Localised text.
 *
 * TS5 v1.5 models `IntendedUse.purpose` and `IntendedUse.privacyPolicy` as
 * `[1..*]` arrays of MultiLangString, and the purpose "SHALL be possible to be
 * displayed localised to the User's language". The Wallet displays both when
 * asking for User approval (ARF `AS-WP-06-015` / `RPA_10`), so this is
 * user-facing text, not an internal label.
 */
export interface LocalisedText {
  /** BCP 47 / ISO 639-1 language tag, lower-cased. */
  readonly lang: string;
  readonly value: string;
}

export const LANG_TAG_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const normaliseLocalisedText = (
  entries: readonly LocalisedText[],
): readonly LocalisedText[] =>
  entries.map((e) => ({ lang: e.lang.toLowerCase(), value: e.value.trim() }));

/** Returns the first entry matching `lang`, else the `en` entry, else the first. */
export const pickLocalised = (
  entries: readonly LocalisedText[],
  lang = "en",
): LocalisedText | undefined => {
  const wanted = lang.toLowerCase();
  return (
    entries.find((e) => e.lang.toLowerCase() === wanted) ??
    entries.find((e) => e.lang.toLowerCase() === "en") ??
    entries[0]
  );
};

export const hasLanguage = (entries: readonly LocalisedText[], lang: string): boolean =>
  entries.some((e) => e.lang.toLowerCase() === lang.toLowerCase());
