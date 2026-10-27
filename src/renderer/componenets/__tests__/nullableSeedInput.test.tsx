import path from 'path';
import React from 'react';
import { isValidNaiSeed } from '../../models/sceneSeedGroups';
import loadComponentFixture from '../testSupport/componentFixture';

type InputProps = {
  label: string;
  value: number | null;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
};
const Input = loadComponentFixture<InputProps>(
  path.resolve(__dirname, '../PreSetEdtior.tsx'),
  'NullIntInput',
  { isValidNaiSeed },
) as (
  props: InputProps,
) => React.ReactElement<React.InputHTMLAttributes<HTMLInputElement>>;

test('seed zero is displayed and remains a valid explicit seed', () => {
  const onChange = jest.fn();
  const element = Input({ label: '시드', value: 0, disabled: false, onChange });
  expect(element.props.value).toBe('0');
  element.props.onChange?.({
    target: { value: '0' },
  } as React.ChangeEvent<HTMLInputElement>);
  expect(onChange).toHaveBeenLastCalledWith(0);
});

test.each(['1.5', '12invalid', '4294967296'])(
  'invalid seed %s is not silently truncated or sent outside the supported integer range',
  (value) => {
    const onChange = jest.fn();
    const element = Input({
      label: '시드',
      value: null,
      disabled: false,
      onChange,
    });
    element.props.onChange?.({
      target: { value },
    } as React.ChangeEvent<HTMLInputElement>);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  },
);
