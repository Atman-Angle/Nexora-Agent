/**
 * A deliberately narrow, deterministic trusted-input parser. It recognises
 * only direct first-person statements whose key is unambiguous. This module
 * is not an NLP/LLM extractor: tool output, assistant text and third-party
 * claims never reach it.
 */
export type DirectFactIntent = {
  key: string;
  value: string;
  sensitive: boolean;
};

export function extractDirectStableFactIntents(text: string): DirectFactIntent[] {
  const source = text.trim();
  const matches: Array<{ pattern: RegExp; key: string; sensitive?: boolean }> = [
    { pattern: /^(?:my name is|i am called)\s+(.+?)[.!。！？]?$/iu, key: "identity.name" },
    { pattern: /^(?:my profession is|i work as)\s+(?:an?\s+)?(.+?)[.!。！？]?$/iu, key: "employment.profession" },
    { pattern: /^(?:my major is|i major in)\s+(.+?)[.!。！？]?$/iu, key: "education.major" },
    { pattern: /^my email is\s+(.+?)[.!。！？]?$/iu, key: "contact.email", sensitive: true },
    { pattern: /^my phone number is\s+(.+?)[.!。！？]?$/iu, key: "contact.phone", sensitive: true },
    { pattern: /^my health condition is\s+(.+?)[.!。！？]?$/iu, key: "health.condition", sensitive: true },
    { pattern: /^(?:我叫|我的名字是)\s*(.+?)[。！？]?$/u, key: "identity.name" },
    { pattern: /^我的(?:职业|工作)是\s*(.+?)[。！？]?$/u, key: "employment.profession" },
    { pattern: /^我的专业是\s*(.+?)[。！？]?$/u, key: "education.major" },
    { pattern: /^我的邮箱是\s*(.+?)[。！？]?$/u, key: "contact.email", sensitive: true },
    { pattern: /^我的电话号码是\s*(.+?)[。！？]?$/u, key: "contact.phone", sensitive: true },
    { pattern: /^我的健康状况是\s*(.+?)[。！？]?$/u, key: "health.condition", sensitive: true }
  ];
  for (const candidate of matches) {
    const result = candidate.pattern.exec(source);
    const value = result?.[1]?.trim();
    if (value !== undefined && value.length > 0) {
      return [{ key: candidate.key, value, sensitive: candidate.sensitive === true }];
    }
  }
  return [];
}
