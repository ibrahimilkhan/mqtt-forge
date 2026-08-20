import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chooseExportFolder, getExportFolder, saveCsv, type ExportFolder } from '../../api/export';
import { queryKeys } from '../../api/queryKeys';

/**
 * Saving a run to a file, and the one thing that decides how.
 *
 * Where the host owns a window it owns a folder dialog, and the readings are written into a
 * folder the reader chose. Where it does not — a browser pointed at the same server — there is no
 * dialog to open and no filesystem to write to, so the file is handed over as a download instead.
 * Both end with a CSV on disk; only one of them lets the reader say where.
 */
export function useExport() {
  const client = useQueryClient();
  const { data } = useQuery({ queryKey: queryKeys.exportFolder, queryFn: getExportFolder });

  const remember = (next: ExportFolder) => client.setQueryData(queryKeys.exportFolder, next);

  const choose = useMutation({ mutationFn: chooseExportFolder, onSuccess: remember });
  const write = useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) => saveCsv(name, content),
  });

  return {
    folder: data?.folder ?? null,
    canChoose: data?.canChoose ?? false,
    choosing: choose.isPending,
    saving: write.isPending,
    choose: () => choose.mutateAsync(),

    /**
     * Save the run, by whichever route this host has.
     *
     * A first save with no folder yet asks for one, so the reader is never told to go and set
     * something up before they can press the button they just pressed.
     */
    save: async (name: string, content: string): Promise<string | null> => {
      if (!data?.canChoose) {
        download(`${name}.csv`, content);

        return null;
      }

      const folder = data.folder ?? (await choose.mutateAsync()).folder;
      if (!folder) return null;

      return (await write.mutateAsync({ name, content })).path;
    },
  };
}

/**
 * The browser's own way of putting a file on disk.
 *
 * It cannot say which folder — that is the browser's business and the reader's settings — but it
 * does end with the same file, which is what the button promised.
 */
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
