import { DOMParser } from "linkedom";

/** Native resvg can read absolute image paths without imagesToResolve().
 * Permit only self-contained geometry and fragment references. Parse attributes
 * before checking them so XML entities and namespace prefixes cannot hide paths. */
export function validateStaticSvg(svg: string): void {
	if (Buffer.byteLength(svg, "utf8") > 2 * 1024 * 1024) throw new Error("SVG exceeds the rendering size limit.");
	if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(svg)) throw new Error("SVG external resources are disabled.");
	const document = new DOMParser().parseFromString(svg, "image/svg+xml");
	if (document.documentElement?.localName.split(":").at(-1)?.toLowerCase() !== "svg") throw new Error("Expected an SVG document.");
	const checkStyle = (style: string) => {
		if (/\\|@import|@font-face/i.test(style)) throw new Error("SVG external resources are disabled.");
		for (const match of style.matchAll(/url\s*\(([^)]*)\)/gi)) {
			if (!/^\s*(['"]?)#[\w.-]+\1\s*$/.test(match[1]!)) throw new Error("SVG external resources are disabled.");
		}
	};
	for (const element of document.querySelectorAll("*")) {
		const tag = element.localName.split(":").at(-1)!.toLowerCase();
		if (["image", "foreignobject", "script"].includes(tag)) throw new Error("SVG external resources are disabled.");
		if (tag === "style") checkStyle(element.textContent ?? "");
		for (const attributeName of element.getAttributeNames()) {
			const value = element.getAttribute(attributeName) ?? "";
			const name = attributeName.split(":").at(-1)!.toLowerCase();
			if (name.startsWith("on")) throw new Error("SVG executable content is disabled.");
			if (name === "href" && !/^#[\w.-]+$/.test(value.trim())) throw new Error("SVG external resources are disabled.");
			checkStyle(value);
		}
	}
}
