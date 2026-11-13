# Recognizable contact names

The contact list currently imports provider names or task titles verbatim. Long descriptions and transcript fragments obscure the identity in every contact picker.

Use one deterministic naming rule at discovery, retaining the complete `sourceName` separately. Preserve names marked `custom`, and treat previously edited or ambiguous legacy identities conservatively as custom. An untouched imported name may follow its provider. The `nameSource` is `provider` or `custom`; changing a discovered display name increments its existing identity version. Accepted run snapshots and historical conversations are never rewritten.

For provider names, normalize whitespace and Markdown heading syntax. Use a short first heading or a prefix separated by a spaced title divider. A label may occupy at most 28 display units (ASCII counts one, other graphemes two). If there is no reliable short title, use the known service name and six stable identifier characters. This is a display fallback, never a new Agent identity or an AI-inferred role. Custom names retain the existing 80-character limit.

Show the full source on hover, in an expandable contact detail, and in the editor. Allow the existing editor to save a personal display name and apply the suggested name. Search matches both names. Connections, bindings, credentials, handles and old run snapshots retain their existing identities. Do not merge or delete same-named contacts; that requires verified upstream identity.

Approaches considered: layout-only truncation leaves the imported identity unreadable; an AI rename would guess a role and require additional execution. A deterministic short label with retained source and explicit custom names directly addresses this request using the existing contact model. No dependencies are added.
