export type ButtonVariant =
  'primary' | 'secondary' | 'ghost' | 'destructive' | 'icon';

/** Shared by Astro controls and buttons created by the browser editor. */
export const buttonClasses = (variant: ButtonVariant = 'secondary') =>
  `pvme-button pvme-button--${variant}`;
