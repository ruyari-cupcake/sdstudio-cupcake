import { fireEvent, render, screen } from '@testing-library/react';
import CompactCombinationPieces from '../../componenets/CompactCombinationPieces';
import type { PromptPiece, Scene } from '../types';

jest.mock('mobx-react-lite', () => ({
  observer: (component: unknown) => component,
}));
jest.mock('../../componenets/CombinationList', () => ({
  columnColor: () => '#000',
  pieceLabel: (piece: { prompt: string }) => piece.prompt,
}));
jest.mock('../../componenets/Tooltip', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));

test('removing a preceding column preserves the surviving control and its focus', () => {
  const first = [{ id: 'first', prompt: 'first' } as PromptPiece];
  const second = [{ id: 'second', prompt: 'second' } as PromptPiece];
  const scene = { slots: [first, second] } as Scene;
  const onSelect = jest.fn();
  const view = render(
    <CompactCombinationPieces
      scene={scene}
      selected={new Set()}
      onSelect={onSelect}
    />,
  );
  const survivor = screen.getByRole('button', { name: 'second' });
  survivor.focus();
  scene.slots.splice(0, 1);
  view.rerender(
    <CompactCombinationPieces
      scene={scene}
      selected={new Set()}
      onSelect={onSelect}
    />,
  );
  expect(screen.getByRole('button', { name: 'second' })).toBe(survivor);
  expect(document.activeElement).toBe(survivor);
  fireEvent.click(survivor);
  expect(onSelect).toHaveBeenCalledWith('0:0', second[0]);
});
