import { permanentRedirect } from "next/navigation";

/**
 * app.letterprove.com is the verification service, not a product anyone signs
 * into: vendors set Proofs up and manage it inside app.letterstory.com, and the
 * product's front door is letterprove.com. What stays here is what buyers and
 * their agents must reach on a host the vendor does not control — the public
 * /proofs/<vendor> pages, the signed /attest documents, /keys, /verify, /docs
 * and the .well-known files.
 *
 * The bare host used to be a second homepage (a directory of every published
 * vendor). It now sends people to the real one. Each published proof page is
 * still reachable at its own URL.
 */
export default function Home(): never {
  permanentRedirect("https://letterprove.com");
}
