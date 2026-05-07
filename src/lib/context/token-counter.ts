import { countTokens } from '@anthropic-ai/tokenizer'

export function exactTokenCount(
  messages: { role: string; content: string }[]
): number {
  try {
    const combinedText = messages.map(m => `${m.role}: ${m.content}`).join('\n')
    return countTokens(combinedText)
  } catch {
    const totalChars = messages
      .map(m => m.content)
      .join('')
      .length
    return Math.ceil(totalChars / 4)
  }
}

export function exactTokenCountText(text: string): number {
  try {
    return countTokens(text)
  } catch {
    return Math.ceil(text.length / 4)
  }
}