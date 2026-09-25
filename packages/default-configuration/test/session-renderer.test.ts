/**
 * Render-only session preservation, trust-boundary and composition checks.
 * @summary Cards session content contract
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionContent, type SessionContentProps } from '../src/streams/lib/session/SessionContent';
import type { SessionRow } from '../src/streams/lib/session/types';

const row: SessionRow = {
  id: 'row',
  kind: 'message',
  role: 'user',
  anchor: 'turn',
  provenance: [{ sourceKey: 'parent', generation: 'one', lineNumber: 1, selector: 'record' }],
  parts: [
    {
      id: 'text',
      kind: 'text',
      text: 'Hello **reader** <script>evil()</script> [bad](javascript:evil)',
      provenance: []
    }
  ]
};
function render(props: Partial<SessionContentProps> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionContent<Record<string, unknown>>, {
      rows: [row],
      disclosures: { open: new Map(), onOpenChange: () => undefined },
      ...props
    })
  );
}

describe('session content', () => {
  it.skip('renders Markdown with inert HTML and unsafe links', () => {
    const html = render();
    expect(html).toContain('<strong>reader</strong>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('data-session-id="text"');
  });

  it.skip('honors controlled disclosure state and bounds oversized raw inspection', () => {
    const raw: SessionRow = {
      ...row,
      parts: [
        {
          id: 'raw',
          kind: 'raw',
          label: 'Unknown record',
          reason: 'unknown',
          text: 'x'.repeat(5 * 1024 * 1024),
          provenance: []
        }
      ]
    };
    const closed = render({ rows: [raw] });
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('xxxx');
    const open = render({
      rows: [raw],
      disclosures: { open: new Map([['raw', true]]), onOpenChange: () => undefined }
    });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('of 5242880');
    expect(open).toContain('Next');
    expect(open.length).toBeLessThan(70000);
  });

  it.skip('inserts only witnessed anchors or explicit sections without discovering a child', () => {
    const html = render({
      insertions: [
        {
          placementId: 'witness',
          childSourceKey: 'child',
          label: 'Child',
          placement: { kind: 'witnessed', parentSourceKey: 'parent', rowId: 'row', partId: 'text', position: 'after' }
        },
        {
          placementId: 'missing',
          childSourceKey: 'other',
          label: 'Other',
          placement: { kind: 'witnessed', parentSourceKey: 'parent', rowId: 'missing', position: 'after' }
        },
        {
          placementId: 'section',
          childSourceKey: 'section-child',
          label: 'Section',
          placement: { kind: 'section', position: 'end' }
        }
      ],
      renderInsertion: (insertion) => `content-${insertion.placementId}`,
      disclosures: {
        open: new Map([
          ['witness', true],
          ['missing', true],
          ['section', true]
        ]),
        onOpenChange: () => undefined
      }
    });
    expect(html).toContain('content-witness');
    expect(html).toContain('content-section');
    expect(html).not.toContain('content-missing');
    expect(html.indexOf('Hello')).toBeLessThan(html.indexOf('content-witness'));
    expect(html).not.toContain('role="log"');
  });

  it.skip('dispatches typed provider rows and parts through ordinary React renderers', () => {
    const html = render({
      rows: [{ ...row, kind: 'provider', providerKind: 'hook', data: { label: 'Hook row' }, parts: [] }],
      providerRows: { hook: ({ data }) => String((data as { label: string }).label) }
    });
    expect(html).toContain('Hook row');
  });
});
