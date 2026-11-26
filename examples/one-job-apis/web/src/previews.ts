/** Static output previews for featured bento tiles (display only). */

export const FEATURED_PREVIEW: Record<string, string> = {
  "hash.sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1f00f8b0cf406dccf9b3960",
  "json.fmt": `{
  "a": 1,
  "b": [
    2,
    3
  ]
}`,
  "text.diff": `  line one
- line two
+ line too`,
};

export const FEATURED_BENTO_CLASS: Record<string, string> = {
  "hash.sha256": "bento-tall",
  "json.fmt": "bento-wide",
  "text.diff": "bento-normal",
};