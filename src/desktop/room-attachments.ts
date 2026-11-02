import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';

export function roomAttachments(input: HTMLTextAreaElement, error: HTMLElement) {
	let data: string | undefined;
	let busy = false;
	let reading = false;
	const preview = document.createElement('div');
	preview.className = 'room-attachment';
	preview.hidden = true;
	const image = document.createElement('img');
	image.alt = 'Image to attach';
	const remove = document.createElement('button');
	remove.type = 'button';
	remove.textContent = 'Remove Image';
	preview.append(image, remove);
	input.after(preview);
	const clear = (): void => {
		data = undefined;
		image.removeAttribute('src');
		preview.hidden = true;
	};
	remove.addEventListener('click', clear);
	const accept = (value: string): void => {
		data = value;
		image.src = value;
		preview.hidden = false;
	};
	const fail = (cause: unknown): void => {
		error.textContent = readableError(cause);
		error.hidden = false;
		reportFault({ level: 'error', source: 'room.attachment', text: faultText(cause) });
	};
	const pasteImage = (): void => {
		if (document.activeElement !== input || busy || reading) return;
		reading = true;
		void window.team
			.clipboardImage()
			.then(accept)
			.catch(fail)
			.finally(() => {
				reading = false;
			});
	};
	window.team.onImagePaste(pasteImage);
	input.addEventListener('keydown', (event) => {
		if (
			event.key.toLowerCase() !== 'v' ||
			!event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey
		)
			return;
		event.preventDefault();
		if (!event.repeat) pasteImage();
	});
	input.addEventListener('paste', (event) => {
		const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
			item.type.startsWith('image/'),
		);
		if (!file) return;
		event.preventDefault();
		if (busy || reading) return;
		if (file.size > 8 * 1024 * 1024) {
			fail(new Error('Room images must be at most 8 MiB.'));
			return;
		}
		const reader = new FileReader();
		reading = true;
		reader.onloadend = () => {
			reading = false;
		};
		reader.onload = () => {
			if (typeof reader.result === 'string') accept(reader.result);
		};
		reader.onerror = () => fail(new Error('Could not read the pasted image.'));
		reader.readAsDataURL(file);
	});
	return {
		loading: () => reading,
		value: () => data,
		clear,
		lock: (value: boolean): void => {
			busy = value;
			remove.disabled = value;
			input.disabled = value;
		},
	};
}

/**
 * A room image, its box reserved before it paints. It used to arrive with no size after an IPC
 * round trip and grow by up to 480px once the log had already scrolled, so a pinned room stopped
 * following the conversation. The size now comes with the data and is set before src;
 * `keepFollowing` re-pins the log as the box takes its size and again when the pixels land, and
 * does nothing for a reader who has scrolled up to older messages.
 */
export function appendRoomImage(item: HTMLElement, id: string, keepFollowing: () => void): void {
	const image = document.createElement('img');
	image.className = 'room-image';
	image.alt = 'Shared room image';
	image.loading = 'lazy';
	image.addEventListener('load', keepFollowing);
	item.append(image);
	void window.team
		.roomImage(id)
		.then(({ data, height, width }) => {
			image.width = width;
			image.height = height;
			keepFollowing();
			image.src = data;
		})
		.catch(() => {
			image.alt = 'Image unavailable';
		});
}
