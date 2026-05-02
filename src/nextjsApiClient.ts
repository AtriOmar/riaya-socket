import axios from "axios";

export function normalizeNextjsBaseUrl(raw?: string): string {
	return (raw || "http://localhost:3000").trim().replace(/\/$/, "");
}

/** Axios client for the Next.js app REST API (`NEXTJS_API_URL`). */
export const nextjsApi = axios.create({
	baseURL: normalizeNextjsBaseUrl(process.env.NEXTJS_API_URL),
	headers: {
		"Content-Type": "application/json",
	},
});
