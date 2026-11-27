/**
 * The gift-payout model, compiled from laws/gift-payout/model.bend in this
 * package. The laws proved about it are in laws/gift-payout/LAWS.bend; the
 * test beside this file runs the same events through it and through cire-api's
 * services and fails when the two disagree.
 */
import model from "../../laws/gift-payout/model.mjs";

export type * from "../../laws/gift-payout/model.mjs";
export { model };
