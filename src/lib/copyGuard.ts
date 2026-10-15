/** Window in which a bubble tap following a link tap is treated as the
 *  link's own press, not a copy request: tapping a link inside a message
 *  bubble also fires the bubble's onPress, which would copy the whole
 *  message on top of opening the link. */
export const LINK_TAP_SUPPRESS_MS = 500;

/** True when `now` falls inside the suppression window after a link tap. */
export function shouldSuppressCopy(lastLinkPressAt: number, now: number = Date.now()): boolean {
  return now - lastLinkPressAt < LINK_TAP_SUPPRESS_MS;
}
