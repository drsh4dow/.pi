import type { SafeHarbor } from "./index.ts";

export interface Rule {
	readonly id: string;
	readonly category: SafeHarbor;
	readonly pattern: RegExp;
	readonly holds: (match: RegExpMatchArray, text: string) => boolean;
}

export const street = String.raw`\d{1,6}\s+(?:[A-Z][a-z]+\.?\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Square|Sq|Trail|Trl)(?![A-Za-z])`;

export const nameValue = String.raw`[a-z][a-z'-]*(?:,? [a-z][a-z'-]*){0,3}`;

export const labelled = ({ label, value }: { readonly label: string; readonly value: string }) =>
	new RegExp(String.raw`(?<![a-z])(?:${label})(?![a-z])[\s"'#:=]{1,4}${value}`, "giu");
