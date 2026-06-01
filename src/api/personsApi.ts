import { nextjsApi } from "./nextjsApiClient.js";

/** In-memory cache of ongoing `POST /api/persons` requests, keyed by phone number,
 *  so both `/incoming-call` and the media-stream `start` event resolve to the
 *  same person id without racing. */
const pendingPersonCreations = new Map<string, Promise<number | null>>();

export type UpdatePersonInput = {
	firstName?: string;
	lastName?: string;
	dateOfBirth?: string;
	gender?: string;
	address?: string;
};

export function ensurePersonRow(phoneNumber: string): Promise<number | null> {
	const trimmed = phoneNumber.trim();
	if (!trimmed) return Promise.resolve(null);

	const existing = pendingPersonCreations.get(trimmed);
	if (existing) return existing;

	const promise = (async (): Promise<number | null> => {
		try {
			console.log(
				"---------------------- ensurePersonRow REQUEST ----------------------",
			);
			console.log("phoneNumber:", trimmed);
			const { data } = await nextjsApi.post<{ id: number }>("/api/persons", {
				phoneNumber: trimmed,
				source: "call",
			});
			console.log(
				"---------------------- ensurePersonRow OK ----------------------",
			);
			console.log("personId:", data.id);
			console.log(
				"-------------------------------------------------------------",
			);
			return data.id;
		} catch (err) {
			console.error(
				"---------------------- ensurePersonRow FAILED ----------------------",
			);
			console.error("[personsApi] ensurePersonRow failed", err);
			console.error(
				"-------------------------------------------------------------",
			);
			return null;
		}
	})();

	pendingPersonCreations.set(trimmed, promise);
	setTimeout(() => pendingPersonCreations.delete(trimmed), 5 * 60 * 1000);
	return promise;
}

export async function updatePersonRow(
	personId: number,
	input: UpdatePersonInput,
): Promise<{ id: number }> {
	const { data } = await nextjsApi.patch<{ id: number }>(
		`/api/persons/${personId}`,
		input,
	);
	return data;
}
