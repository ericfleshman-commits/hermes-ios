export function shouldOpenDrawerGesture(startX: number, dx: number, dy: number): boolean {
  return startX <= 28 && startX >= 0 && dx > 12 && dx > Math.abs(dy) * 1.2;
}

export function drawerOffset(open: boolean, width: number, dx: number): number {
  return Math.max(-width, Math.min(0, (open ? 0 : -width) + dx));
}

export function settleDrawerOpen(open: boolean, width: number, dx: number, vx: number): boolean {
  if (Math.abs(vx) > 0.55 && Math.sign(vx) === Math.sign(dx)) return vx > 0;
  return drawerOffset(open, width, dx) > -width / 2;
}
