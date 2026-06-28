export function isSenderAllowed(senderOpenId: string, allowedIds: string[]): boolean {
  return allowedIds.includes(senderOpenId);
}
