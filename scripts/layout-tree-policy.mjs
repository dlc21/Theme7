const CLIENT_IDENTITY_PART_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

export function isValidClientIdentityPart(value) {
  return typeof value === "string" && CLIENT_IDENTITY_PART_PATTERN.test(value)
}

export function updatePaneInTree(tree, paneId, update) {
  if (tree?.kind === "pane") return tree.id === paneId ? update(tree) : tree
  if (tree?.kind === "tabs") return { ...tree, panes: tree.panes.map((pane) => updatePaneInTree(pane, paneId, update)) }
  if (tree?.kind === "split") return { ...tree, first: updatePaneInTree(tree.first, paneId, update), second: updatePaneInTree(tree.second, paneId, update) }
  return tree
}
