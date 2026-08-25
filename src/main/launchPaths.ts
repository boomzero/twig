import { isAbsolute, normalize, resolve } from 'path'

export function presentationPathsFromArgv(
  argv: string[],
  workingDirectory: string = process.cwd()
): string[] {
  return argv
    .filter((argument) => argument.toLowerCase().endsWith('.tb'))
    .map((argument) =>
      isAbsolute(argument) ? normalize(argument) : resolve(workingDirectory, argument)
    )
}
