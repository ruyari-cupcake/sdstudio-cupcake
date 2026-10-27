import React, { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  onErr?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/** Keeps render exceptions visible and permits a view remount without reloading services. */
export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    try {
      const { onErr } = this.props;
      onErr?.(error, errorInfo);
    } catch (reportError) {
      console.error('Could not report renderer error', reportError);
    }
  }

  render() {
    const { hasError, error } = this.state;
    const { children } = this.props;
    if (hasError) {
      return (
        <main
          role="alert"
          className="h-full w-full flex flex-col items-center justify-center gap-4 p-8 bg-[var(--c-surface)] text-body"
        >
          <h1 className="text-xl font-bold">
            화면을 표시하는 중 오류가 발생했습니다
          </h1>
          <p>화면을 다시 표시하거나 오류 내용을 복사해 문제를 알려주세요.</p>
          <pre className="max-w-full whitespace-pre-wrap break-words text-sm">
            {error?.message || '알 수 없는 화면 오류'}
          </pre>
          <button
            type="button"
            className="px-4 py-2 rounded-lg btn-solid-orange text-sm font-medium transition-colors"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            화면 다시 표시
          </button>
        </main>
      );
    }
    return children;
  }
}
