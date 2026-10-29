export type Check = { name: string; wf: string; status: string; conclusion: string; url: string }
export type Note = { author: string; body: string; at: string; kind: 'comment' | 'review'; state: string }
export type OpenPr = {
  number: number
  title: string
  url: string
  isDraft: boolean
  reviewDecision: string
  mergeStateStatus: string
  headRefName: string
  updatedAt: string
  checks: Check[]
  notes: Note[]
}
export type SessionPr = Omit<OpenPr, 'headRefName' | 'updatedAt'> & { state: string; isFetched: boolean }
export type MergedPr = { number: number; title: string; url: string; mergedAt: string }
export type PrData = { open: OpenPr[]; merged: MergedPr[]; fetchedAt: number; error: string; isLoading: boolean }

declare module 'claude-code' {
  interface PluginState {
    'pr-tracker': {
      data: Shaped<PrData>
      expanded: Shaped<number>
      mergedOffset: Shaped<number>
      sessionPrs: Shaped<SessionPr[]>
    }
  }
}
