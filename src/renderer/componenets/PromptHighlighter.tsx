import { observer } from 'mobx-react-lite';
import { appState } from '../models/AppService';
import { highlightPrompt } from '../models/PromptService';

interface PromptHighlighterProps {
  text: string;
  className?: string;
}

export const PromptHighlighter = observer(
  ({ className, text }: PromptHighlighterProps) => {
    const { curSession } = appState;
    return (
      <div
        className={`max-w-full break-words bg-[var(--c-input-bg)] ${className ?? ''}`}
        // highlightPrompt escapes prompt text and encodes tooltip attributes at its single HTML boundary.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: highlightPrompt(curSession!, text) }}
      />
    );
  },
);
