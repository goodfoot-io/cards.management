/**
 * The antigravity-session renderer's pure data path: parsing destination
 * records, folding them into bounded compact state, adapting that state to the
 * shared compact card, and turning records into transcript items and their
 * native session projection.
 *
 * @summary Antigravity record parsing, compact state and transcript conversion
 * @module streams/antigravity-session/www/lib/index
 */

export * from './adapt-compact-model';
export * from './compact-state';
export * from './parser';
export * from './project-session';
export * from './render-transcript';
