// SPDX-License-Identifier: Apache-2.0
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

describe('App shell', () => {
  it('renders the product name and the descriptive Godot attribution', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'ModuleX Game Studio' })).toBeTruthy();
    expect(screen.getByText(/Built with the Godot Engine/)).toBeTruthy();
  });
});
