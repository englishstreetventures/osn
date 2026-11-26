/**
 * The deletion model, compiled from laws/account-deletion/model.bend in this
 * package (the helpers that turn JavaScript values into Bend's and back are in
 * `./bend`).
 * The laws proved about it are in laws/account-deletion/LAWS.bend; the tests
 * beside this file run the same events through it and through cire-api's
 * services and fail when the two disagree.
 */
import model from "../../laws/account-deletion/model.mjs";

export type * from "../../laws/account-deletion/model.mjs";
export { model };
