// Serializes the assembly: a pipe-file diff test's unscoped temp-dir glob can otherwise
// catch another test class's concurrently-held pipe and fail on a non-leak
[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]
