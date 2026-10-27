import { Script } from 'vm';
import { highlightPrompt } from '../PromptService';
import type { Session } from '../types';

jest.mock('..', () => ({
  isMobile: false,
  promptService: {
    tryExpandPiece: jest.fn(() => 'expanded'),
    isGlobal: jest.fn(() => false),
    isMulti: jest.fn(() => false),
  },
  globalPieceService: { library: new Map() },
}));

function renderHighlight(text: string) {
  const element = document.createElement('div');
  element.innerHTML = highlightPrompt({} as Session, text);
  return element;
}

describe('prompt highlight HTML boundary', () => {
  it.each([
    ['ordinary tags', 'text &amp; <b>x</b> and <i>y</i>'],
    ['syntax error', 'unmatched ( &amp; <b>x</b><i>y</i>'],
    [
      'comment and following text',
      '## <b>x</b> && "<i>" ##, after &amp; <u>z</u>',
    ],
    ['multiple lines', 'line 1 &lt; <b>bold</b>\nline 2 <em>x</em> &amp;'],
    [
      'literal entities and quotes',
      '&quot; &#39; &lt; &gt; "quoted" \'quoted\'',
    ],
  ])('preserves %s as text without interpreting markup', (_label, text) => {
    const element = renderHighlight(text);

    expect(element.textContent).toBe(text);
    expect(
      element.querySelectorAll('b, i, u, em, script, img, svg'),
    ).toHaveLength(0);
    for (const child of Array.from(element.querySelectorAll('*'))) {
      expect(child.tagName).toBe('SPAN');
    }
  });

  it('passes exact wildcard text through both HTML and JavaScript quoting boundaries', () => {
    const piece = '<lib.name\'"\\ &amp; &quot;>';
    const element = renderHighlight(piece);
    const wildcard = element.querySelector('.syntax-wildcard');
    const showPromptTooltip = jest.fn();
    const clearPromptTooltip = jest.fn();
    const event = { clientX: 14, clientY: 27 };
    const scope = {
      window: { promptService: { showPromptTooltip, clearPromptTooltip } },
      event,
    };

    expect(element.textContent).toBe(piece);
    expect(wildcard).not.toBeNull();
    expect(
      Array.from(wildcard!.attributes, (attribute) => attribute.name).sort(),
    ).toEqual(['class', 'onmousemove', 'onmouseout']);
    new Script(wildcard!.getAttribute('onmousemove')!).runInNewContext(scope);
    new Script(wildcard!.getAttribute('onmouseout')!).runInNewContext(scope);
    expect(showPromptTooltip).toHaveBeenCalledTimes(1);
    expect(showPromptTooltip).toHaveBeenCalledWith(piece, event);
    expect(clearPromptTooltip).toHaveBeenCalledTimes(1);
  });

  it('retains split-marker tooltip behavior', () => {
    const element = renderHighlight('|');
    const split = element.querySelector('.syntax-split');
    const showPromptTooltip = jest.fn();
    const event = { clientX: 0, clientY: 0 };

    expect(element.textContent).toBe('|');
    expect(split).not.toBeNull();
    new Script(split!.getAttribute('onmousemove')!).runInNewContext({
      window: { promptService: { showPromptTooltip } },
      event,
    });
    expect(showPromptTooltip).toHaveBeenCalledWith('|', event);
  });
});
