import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import App from './App';

jest.mock('axios');

test('renders groups from /api/tracks', async () => {
  axios.get.mockResolvedValue({ data: { music: { battle: [{ name: 'b1.opus', relPath: 'music/battle/b1.opus' }] }, soundEffects: {} } });
  render(<App />);
  await waitFor(() => expect(screen.getByText('battle')).toBeInTheDocument());
});
