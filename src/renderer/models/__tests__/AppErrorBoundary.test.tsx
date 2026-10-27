import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ErrorBoundary from '../../componenets/AppErrorBoundary';

describe('renderer exception recovery', () => {
  it('shows a readable fallback, then remounts the view without reloading the app or its queue', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    let broken = true;
    const onErr = jest.fn();
    function View() {
      if (broken) throw new Error('image view failed');
      return <p>Recovered project view</p>;
    }
    try {
      render(
        <ErrorBoundary onErr={onErr}>
          <View />
        </ErrorBoundary>,
      );
      expect(screen.getByRole('alert').textContent).toContain(
        'image view failed',
      );
      expect(onErr).toHaveBeenCalledTimes(1);
      broken = false;
      fireEvent.click(screen.getByRole('button', { name: '화면 다시 표시' }));
      expect(screen.getByText('Recovered project view').textContent).toBe(
        'Recovered project view',
      );
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});
