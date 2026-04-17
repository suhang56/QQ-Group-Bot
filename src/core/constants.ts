/**
 * Cross-module runtime constants.
 *
 * Kept in a tiny leaf module (no project imports) so any module can reuse
 * these without pulling in a sibling module's surface area.
 */

/**
 * Admin user whose DMs are treated as the moderation-approval queue endpoint
 * and whose userId bypasses the in-group appeal rate limiter. Override with
 * the `MOD_APPROVAL_ADMIN` env var; defaults to the operator's own QQ.
 */
export const MOD_APPROVAL_ADMIN = process.env['MOD_APPROVAL_ADMIN'] ?? '2331924739';
