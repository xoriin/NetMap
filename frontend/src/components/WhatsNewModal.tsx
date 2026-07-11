import DOMPurify from "dompurify";
import { ExternalLink } from "lucide-react";
import { marked } from "marked";
import { type ChangelogRelease, type User, type VersionInfo } from "../api/client";
import { Modal } from "./Modal";

export function shouldShowWhatsNew(versionInfo: VersionInfo | null, user: User | null) {
  if (!versionInfo?.current || !user) return false;
  return user.whats_new_acknowledged_version !== versionInfo.current;
}

function renderInlineMarkdown(markdown: string) {
  const html = marked.parseInline(markdown, {
    async: false,
    breaks: true,
    gfm: true,
  });
  return DOMPurify.sanitize(html, {
    ALLOWED_ATTR: ["href", "title"],
    ALLOWED_TAGS: ["a", "br", "code", "del", "em", "s", "strong"],
  });
}

function MarkdownInline({ text }: { text: string }) {
  return (
    <span
      className="whats-new-markdown"
      dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(text) }}
    />
  );
}

function ChangelogItem({ text }: { text: string }) {
  return (
    <li>
      <MarkdownInline text={text} />
    </li>
  );
}

function ChangelogReleaseBlock({ release }: { release: ChangelogRelease }) {
  return (
    <section className="whats-new-release">
      {release.sections.map((section) => (
        <div className="whats-new-section" key={`${release.version}-${section.category}`}>
          <h4 className="whats-new-section-title">{section.category}</h4>
          <ul className="whats-new-list">
            {section.items.map((item) => (
              <ChangelogItem key={item} text={item} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function WhatsNewModal({
  onClose,
  versionInfo,
}: {
  onClose: () => void;
  versionInfo: VersionInfo;
}) {
  const releases = versionInfo.whats_new ?? [];
  const hasHighlights = releases.some((release) => release.sections.length > 0);
  const releaseUrl = versionInfo.current_release_url
    ?? `https://github.com/xoriin/netmap/releases/tag/v${versionInfo.current}`;
  return (
    <Modal
      title={`What's new in v${versionInfo.current}`}
      onCancel={onClose}
      size={hasHighlights ? "md" : "sm"}
      footer={(
        <>
          <a className="nm-btn nm-btn--secondary" href={releaseUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden="true" />
            Release notes
          </a>
          <button type="button" className="nm-btn nm-btn--primary" onClick={onClose}>
            Got it
          </button>
        </>
      )}
    >
      <div className="modal-body whats-new-modal-body">
        <div className="whats-new-version-card">
          <span>Installed version</span>
          <strong>{versionInfo.channel ? `${versionInfo.channel}: ` : "v"}{versionInfo.current}</strong>
        </div>
        {hasHighlights ? (
          <div className="whats-new-highlights">
            {releases.map((release) => (
              <ChangelogReleaseBlock key={release.version} release={release} />
            ))}
          </div>
        ) : (
          <p>Review the release notes for details about this version.</p>
        )}
      </div>
    </Modal>
  );
}
