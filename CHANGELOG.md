# Change log

All notable changes to this project will be documented in this file.

## main branch

### Breaking changes

- Added `unconditional-prompt-end` input with a default. Its contents were previously included in both prompts in the example, so configurations will need to be changed on update.

### Changes

- Added `additional-allowed-tools` input.
- Removed “resolve” from example prompts; Claude cannot actually resolve comments with the GitHub REST API.
- Added input to configure [gh-pr-render] version.
- Updated [gh-pr-render] to version 0.3.0 to render labels and use blockquotes to ensure that content is distinct from structure.
- Added defaults for `initial-review-prompt` and `re-review-prompt`.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render

## Release 1.0.2 (2026-06-12)

- Fix [gh-pr-render] usage.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render

## Release 1.0.1 (2026-06-12)

- Enable immutable releases.
- Fix generic heredoc delimiter that could be accidentally used within content.
- Pin [gh-pr-render] to version 0.2.0.

[gh-pr-render]: https://github.com/danielparks/gh-pr-render

## Release 1.0.0 (2026-05-28)

Initial release.
