import type { TeammateTemplate } from '../teammate-templates.ts';

import { reportFault } from './fault-report.ts';
import { PM_DEFAULT_NAME } from './member-type.ts';

/**
 * One row of chips above the Add teammate form, which FILLS the form rather than replacing it.
 *
 * Phillip asked for a gallery at #4318 and agreed this shape at #4329. The reason it is a row and
 * not a gallery of cards is #4304, two hours earlier: that dialog had just been reported as
 * cluttered and jumpy, and the answer was a static size where somebody adding their first teammate
 * meets three fields rather than ten. Seven cards with descriptions would have undone exactly that.
 * A row of chips adds one line; picking one writes Name, Expertise and Domain, and the form below is
 * the same form it already was.
 *
 * Only on the ADD path. Choosing a character for somebody who already exists would overwrite what
 * the user wrote, and there is no undo in this dialog.
 *
 * THE CHARACTERS COME FROM DISK NOW (#4686), read fresh each time Add is opened, so editing a file
 * in `gallery/` shows up without a rebuild. Which means this has to cope with a directory that is
 * empty, partly unreadable, or absent - see `warn` below.
 */
export function setupTeammateGallery(
	form: HTMLElement,
	fill: (template: TeammateTemplate) => void,
	onError: (error: unknown) => void,
	memberType: HTMLSelectElement,
): { chosen: () => string; ready: () => void; show: (adding: boolean) => void } {
	/*
	 * START BLANK IS BUILT HERE rather than read from a file. It is the absence of a character, not
	 * one of them, and it must never be the thing that fails to load: whatever happened to the
	 * directory, writing the teammate yourself has to stay available, because that is the path that
	 * worked before a gallery existed.
	 */
	const blank: TeammateTemplate = {
		blurb: 'Write the whole thing yourself.',
		domain: '',
		expertise: '',
		id: 'start-blank',
		specialty: 'Start blank',
		suggestedName: '',
	};
	/*
	 * PROJECT MANAGER IS ALSO BUILT HERE (#5338), for a different reason. It is not a character: a PM
	 * has no expertise or domain to fill, because Summon supplies both. What choosing it changes is
	 * the MEMBER TYPE, which no file in `gallery/` can express and none should be able to - a JSON
	 * file that could switch what kind of member is being created would be content deciding
	 * something structural. So it sits beside Start blank as the second thing that is always offered.
	 */
	const manager: TeammateTemplate = {
		blurb: 'Coordinates the team. Summon supplies its remit, so there is nothing to write.',
		domain: '',
		expertise: '',
		id: 'project-manager',
		specialty: 'Project manager',
		suggestedName: PM_DEFAULT_NAME,
	};
	const builtIn = [blank, manager];
	/*
	 * THE SECOND ROW (#5602/#5603): the roles that are not about building software, set apart so
	 * a row of engineering characters does not read as the whole of what a teammate can be; the
	 * ADHD coach and healthcare advocate joined the first four at #6410. They start under Project
	 * manager rather than under Start blank, because Start blank is the absence of a character and
	 * sits alone in its own column. Named here by id, so the files stay six plain fields and nothing
	 * in gallery/ can decide layout.
	 */
	const secondRow = [
		'research-assistant',
		'records-organizer',
		'writing-partner',
		'learning-coach',
		'adhd-coach',
		'healthcare-advocate',
	];
	const row = document.createElement('div');
	row.id = 'maint-gallery';
	const label = document.createElement('p');
	label.className = 'maint-gallery-label';
	label.id = 'maint-gallery-label';
	label.textContent = 'Start from';
	const chips = document.createElement('div');
	chips.className = 'maint-gallery-chips';
	chips.setAttribute('role', 'group');
	chips.setAttribute('aria-labelledby', 'maint-gallery-label');
	// The blurb lives in one line under the row rather than on every chip: eight blurbs at once is a
	// wall of text, and the one you are pointing at is the only one you are reading.
	const blurb = document.createElement('p');
	blurb.className = 'maint-gallery-blurb';
	blurb.setAttribute('role', 'status');
	blurb.textContent = blank.blurb;
	/*
	 * What could not be read, said plainly and without stopping anything. A character that silently
	 * vanished would leave the operator believing the gallery is complete; a thrown error would cost
	 * them the Add form entirely for the sake of one bad file.
	 */
	const warn = document.createElement('p');
	warn.className = 'maint-gallery-warning';
	warn.setAttribute('role', 'status');
	warn.hidden = true;
	let templates: TeammateTemplate[] = builtIn;
	const buttons = new Map<string, HTMLButtonElement>();

	// Which chip is chosen, held here rather than read back off the buttons: the row is redrawn when
	// the gallery finishes loading, and a choice made while that read was still out has to survive it.
	let chosen = blank;
	const press = (template: TeammateTemplate): void => {
		chosen = template;
		for (const [id, button] of buttons)
			button.setAttribute('aria-pressed', String(id === template.id));
		blurb.textContent = template.blurb;
	};
	// Whose text the teammate fields currently hold. Project manager clears them, so it counts as
	// blank; that is what makes the by-hand switch below able to say something true.
	let written = blank;
	const select = (template: TeammateTemplate): void => {
		press(template);
		written = template === manager ? blank : template;
		// Filled BEFORE the type changes: the type's own handler defaults a project manager's names
		// only where they are empty, so it has to see the name this chip just wrote.
		fill(template);
		// Every chip sets the type, not only this one. Otherwise choosing Project manager and then
		// Engineer would leave an engineer registered as a project manager with its fields hidden.
		const type = template === manager ? 'pm' : 'teammate';
		if (memberType.value !== type) {
			memberType.value = type;
			memberType.dispatchEvent(new Event('change'));
		}
	};
	// The other direction. Member type can still be changed by hand, and the row must not go on
	// showing Engineer as chosen above a form that is now a project manager's - or the reverse.
	memberType.addEventListener('change', () => {
		const pressed = buttons.get(manager.id)?.getAttribute('aria-pressed') === 'true';
		if (memberType.value === 'pm' && !pressed) press(manager);
		// Back to the chip whose text is still in the fields, not to Start blank regardless: switching
		// the type by hand hides those fields without emptying them.
		else if (memberType.value !== 'pm' && pressed) press(written);
	});
	const chip = (template: TeammateTemplate): HTMLButtonElement => {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = template.specialty;
		button.title = template.blurb;
		button.setAttribute('aria-pressed', String(template.id === chosen.id));
		button.addEventListener('click', () => {
			select(template);
		});
		// Pointing at a chip explains it without committing to it, so the row can be read by moving
		// along it rather than by choosing seven times and undoing six.
		for (const event of ['mouseenter', 'focus'])
			button.addEventListener(event, () => {
				blurb.textContent = template.blurb;
			});
		return button;
	};
	const draw = (): void => {
		buttons.clear();
		chips.replaceChildren();
		const place = (template: TeammateTemplate, parent: HTMLElement): void => {
			const button = chip(template);
			buttons.set(template.id, button);
			parent.append(button);
		};
		// Start blank in a column of its own; everything else in a second column, so a wrapped or
		// second row lines up under Project manager.
		place(blank, chips);
		const first = document.createElement('div');
		first.className = 'maint-gallery-row';
		const second = document.createElement('div');
		second.className = 'maint-gallery-row';
		for (const template of templates)
			if (template !== blank && !secondRow.includes(template.id)) place(template, first);
		// In the order they were asked for, not the files' alphabetical order.
		for (const id of secondRow) {
			const template = templates.find((entry) => entry.id === id);
			if (template) place(template, second);
		}
		chips.append(first);
		if (second.childElementCount > 0) chips.append(second);
		// A chosen character whose file has since gone leaves nothing pressed to redraw, so fall back.
		if (!buttons.has(chosen.id)) press(blank);
		blurb.textContent = chosen.blurb;
	};
	draw();

	chips.addEventListener('mouseleave', () => {
		const pressed = [...buttons.values()].find(
			(button) => button.getAttribute('aria-pressed') === 'true',
		);
		blurb.textContent =
			templates.find((template) => buttons.get(template.id) === pressed)?.blurb ??
			blank.blurb;
	});
	row.append(label, chips, blurb, warn);
	form.prepend(row);

	const load = (): void => {
		void window.team
			.gallery()
			.then((snapshot) => {
				// The two built-in ids are reserved. A file in gallery/ that reuses one would take over
				// that chip's entry in the map and leave two chips answering to one id - and one of them
				// is the chip that decides the member type. Skipped, and said so.
				const reserved = new Set(builtIn.map((template) => template.id));
				const usable = snapshot.templates.filter((template) => !reserved.has(template.id));
				const warnings = [
					...snapshot.warnings,
					...snapshot.templates
						.filter((template) => reserved.has(template.id))
						.map(
							(template) =>
								`a gallery file uses the reserved id "${template.id}" and was skipped`,
						),
				];
				templates = [...builtIn, ...usable];
				draw();
				warn.hidden = warnings.length === 0;
				// The loader's warnings already say what happened - a skipped file names itself, a
				// missing directory says so. Counting them as skipped FILES was wrong for the second
				// case: it reported "1 character file(s) skipped" when no file had been skipped and
				// there was no directory to skip one from.
				warn.textContent = warnings.join('; ');
				for (const warning of warnings)
					reportFault({ level: 'warning', source: 'gallery.load', text: warning });
			})
			.catch((cause: unknown) => {
				// The built-in two are already drawn, so the form still works; say why the rest is missing.
				warn.hidden = false;
				warn.textContent =
					'The character gallery could not be read, so only Start blank and Project manager are offered.';
				onError(cause);
			});
	};

	return {
		// Which starter the new member is being created from, so it can take that starter's icon.
		chosen: (): string => chosen.id,
		/*
		 * The row cannot be used until the dialog has finished loading its form. Opening Add resets
		 * every field, Member type included, a few milliseconds AFTER the row is on screen, so a chip
		 * pressed in that gap had its work wiped and stayed pressed over a form that no longer agreed
		 * with it. Inert rather than hidden: the row keeps its place, so nothing moves when it wakes.
		 * This waits for the form only. The built-in chips are usable while the character files are
		 * still being read.
		 */
		ready: (): void => {
			row.inert = false;
		},
		show: (adding: boolean): void => {
			row.hidden = !adding;
			row.inert = true;
			if (!adding) return;
			// Reopening Add starts from blank again, so a character chosen last time does not look
			// chosen for a teammate it was never applied to - and re-reads the directory, which is
			// the point of the files being files.
			press(blank);
			written = blank;
			load();
		},
	};
}
