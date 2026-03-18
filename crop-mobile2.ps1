Add-Type -AssemblyName System.Drawing

$srcPath = 'C:\Users\steph\Desktop\5starflow\.claude\screenshots\index-t2-mobile-full2.png'
$src = [System.Drawing.Bitmap]::new($srcPath)

Write-Host "Image size: $($src.Width) x $($src.Height)"

$crops = @(
  @{name="m-features-detail"; y=3000; h=1000},
  @{name="m-testimonials-detail"; y=4200; h=1200},
  @{name="m-pricing-detail"; y=5200; h=1200}
)

foreach ($c in $crops) {
  $h = [Math]::Min($c.h, $src.Height - $c.y)
  if ($h -le 0) { Write-Host "Skipping $($c.name) - out of bounds"; continue }
  $rect = [System.Drawing.Rectangle]::new(0, $c.y, $src.Width, $h)
  $bmp = $src.Clone($rect, $src.PixelFormat)
  $outPath = "C:\Users\steph\Desktop\5starflow\.claude\screenshots\mobile2-$($c.name).png"
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Saved: $outPath"
}
$src.Dispose()
Write-Host "Done"
