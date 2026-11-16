import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { converse, type Image, type Scene } from "./conversation.ts";
import type { CleanCase, Entry, PhiCase } from "./manifest.ts";
import { type Random, unique } from "./random.ts";

/** The committed JPEG fixtures in `images/`, which `images/render.sh` documents. */
export interface Images {
	/** A StyleGAN portrait of nobody. */
	readonly face: Uint8Array;
	/** A claims screen showing a synthetic patient's full name and date of birth. */
	readonly claimScreenshot: Uint8Array;
	/** The same screen with counts and internal claim ids only. */
	readonly cleanScreenshot: Uint8Array;
}

export const loadImages = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const read = (name: string) => fs.readFile(path.join(import.meta.dirname, "images", name));

	return {
		face: yield* read("face.jpeg"),
		claimScreenshot: yield* read("claim-screenshot.jpeg"),
		cleanScreenshot: yield* read("clean-screenshot.jpeg"),
	} satisfies Images;
});

/** The entries that can carry an image: a user attachment or a tool's output. */
const imageEntries: Arr.NonEmptyReadonlyArray<typeof Entry.Type> = ["user", "tool-result", "file-read", "steering"];

const stampLength = 30;

/** The JPEG COM marker, FF FE. */
const commentMarker = [255, 254];

/**
 * The JPEG with a comment segment holding `stamp` right after its start-of-image marker. The stamp starts at byte 6,
 * a multiple of 3, so its own base64 is a substring of the image's base64, which no other image in the file shares.
 */
const stamped = (jpeg: Uint8Array, stamp: Uint8Array) => {
	const bytes = new Uint8Array(jpeg.length + 4 + stamp.length);
	const length = stamp.length + 2;

	bytes.set(jpeg.subarray(0, 2));
	bytes.set([...commentMarker, length >> 8, length % 256], 2);
	bytes.set(stamp, 6);
	bytes.set(jpeg.subarray(2), 6 + stamp.length);

	return bytes;
};

const jpeg = (bytes: Uint8Array): Image => ({ mimeType: "image/jpeg", data: Base64.encode(bytes) });

const screenshotScene: Scene = {
	asks: [
		"The claims grid renders this row wrong. Screenshot attached.",
		"Why does the denial screen show this? See the screenshot.",
		"The UI cuts off this row. Here's what the support agent sees.",
	],
	commands: ["playwright screenshot http://localhost:3000/claims/denials screenshots/claims-denials.jpeg"],
	paths: ["screenshots/claims-denials.jpeg"],
};

const photoScene: Scene = {
	asks: [
		"The intake upload rejects this patient photo. Is the file the problem?",
		"The badge printer crops this photo badly. Can you see why?",
		"The chart thumbnail renders this photo too dark. Here it is.",
	],
	commands: ["aws s3 cp s3://nfh-intake/photos/latest.jpeg photos/latest.jpeg"],
	paths: ["photos/latest.jpeg"],
};

const perImage = 20;

const perCleanScreenshot = 32;

const imageMessages = ({
	rng,
	scene,
	image,
	turn,
}: {
	readonly rng: Random;
	readonly scene: Scene;
	readonly image: Image;
	readonly turn: number;
}) =>
	converse({
		entry: imageEntries[turn % imageEntries.length] ?? "user",
		scene,
		parts: [rng.pick(scene.paths)],
		image: Option.some(image),
		quotes: [],
		rng,
	});

interface ImageRequest {
	readonly images: Images;
	readonly rng: Random;
	readonly used: Set<string>;
}

/**
 * Cases whose identifier is an image: a face photo, and a screenshot showing a synthetic name and full date of birth.
 * Each case stamps its copy, so its canary is unique across the file.
 */
export const imageCases = ({ images, rng, used }: ImageRequest): ReadonlyArray<Omit<typeof PhiCase.Type, "id">> => {
	const sources = [
		{ identifier: "face-photo", bytes: images.face, scene: photoScene },
		{ identifier: "patient-name", bytes: images.claimScreenshot, scene: screenshotScene },
	] as const;

	return Arr.flatMap(sources, ({ identifier, bytes, scene }) =>
		Arr.makeBy(perImage, (turn) => {
			const stamp = unique({ used, draw: () => rng.hex(stampLength) });
			const image = jpeg(stamped(bytes, new TextEncoder().encode(stamp)));
			const messages = imageMessages({ rng, scene, image, turn });
			const entry = imageEntries[turn % imageEntries.length] ?? "user";

			return {
				expect: "phi",
				strata: { identifier, carrier: "screenshot", transform: "plain", entry },
				canaries: [Base64.encode(stamp)],
				fragments: [],
				messages,
			} as const;
		}),
	);
};

/** Cases that attach a screenshot of the claims UI with no identifier on it. */
export const cleanImageCases = ({
	images,
	rng,
}: Omit<ImageRequest, "used">): ReadonlyArray<Omit<typeof CleanCase.Type, "id">> =>
	Arr.makeBy(perCleanScreenshot, (turn) => ({
		expect: "clean",
		strata: { negative: "clean-screenshot" },
		canaries: [],
		fragments: [],
		messages: imageMessages({ rng, scene: screenshotScene, image: jpeg(images.cleanScreenshot), turn }),
	}));
