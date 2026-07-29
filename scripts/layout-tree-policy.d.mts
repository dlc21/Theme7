export function isValidClientIdentityPart(value: unknown): value is string
export function updatePaneInTree<T>(tree: T, paneId: string, update: (pane: T) => T): T
