// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainCard } from "./DomainCard";

// Without this, React logs "not configured to support act(...)" and batches
// updates less predictably — vitest doesn't set it for us.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// document.visibilityState is a getter in real browsers; jsdom exposes the
// same shape, so it has to be overridden the same way to fake tab focus.
function setVisibility(state: DocumentVisibilityState) {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => state,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

describe("DomainCard focus revalidation", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	async function renderCard() {
		await act(async () => {
			root.render(
				<DomainCard
					domain="example.com"
					record="letterprove-verify=abc123"
					hosts={["_letterprove.example.com", "example.com"]}
					verifiedAt={null}
				/>,
			);
		});
	}

	it("re-checks verification when the tab regains focus, with no click", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			json: () => Promise.resolve({ verified: true, verifiedAt: "2026-08-20T00:00:00.000Z" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await renderCard();
		expect(fetchMock).not.toHaveBeenCalled();

		await act(async () => {
			setVisibility("visible");
		});

		expect(fetchMock).toHaveBeenCalledWith("/api/vendor/verify-domain", { method: "POST" });
		expect(container.textContent).toContain("Verified");
	});

	it("does not check while the tab is hidden", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await renderCard();

		await act(async () => {
			setVisibility("hidden");
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stops checking once verified", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			json: () => Promise.resolve({ verified: true, verifiedAt: "2026-08-20T00:00:00.000Z" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await renderCard();
		await act(async () => {
			setVisibility("visible");
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			setVisibility("hidden");
		});
		await act(async () => {
			setVisibility("visible");
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
