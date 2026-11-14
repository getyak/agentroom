# Anime portraits for people

Tracking: [GET-529](https://linear.app/getyak/issue/GET-529/give-people-expressive-anime-avatars).

The owner and human contacts use original anime character portraits with expressive faces. The green character is the owner's default; five further characters give other identities varied hair, expressions and colors. These are fictional defaults, not likenesses inferred from a contact's name. Contact identity selects a bundled local image; no contact details are sent to an image service.

The same helper supplies the owner rail, people contacts, messages, group collages and guest views. Existing identity keys remain unchanged, so renaming or reloading a contact keeps the same image. Roomie continues to use the existing application mascot, and Agent portraits keep their existing presentation.

Tool: built-in `image_gen.imagegen`, 2026-11-13. All images are copied without pixel edits, with opaque pale backgrounds suitable for rounded-square/circle avatar masks. Asset files: `packages/brand/assets/people-anime-{green,coral,sky,amber,violet,silver}.png`.

The green portrait used the application icon as a palette/personality reference. Subsequent characters used the green portrait as a style/framing reference, with different fictional adult subjects. The [exact prompts](people-anime-prompts.json) include the initial green prompt's original workspace-steward framing; the finished portrait is used for the owner after the user clarified the target.
